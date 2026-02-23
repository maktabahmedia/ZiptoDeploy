import { Octokit } from "octokit";
import JSZip from "jszip";
import { Buffer } from "buffer";

export interface DeployStatus {
  step: string;
  details?: string;
  type: "info" | "success" | "error";
}

export type StatusCallback = (status: DeployStatus) => void;

export interface ZipAnalysis {
  zip: JSZip;
  fileCount: number;
  totalSize: number;
  projectType: "Static Website" | "Node.js Project" | "Unknown";
  files: { path: string; size: number; entry: JSZip.JSZipObject }[];
}

export async function analyzeZip(file: File): Promise<ZipAnalysis> {
  const zip = new JSZip();
  await zip.loadAsync(file);
  
  const rawFiles: { path: string; entry: JSZip.JSZipObject }[] = [];
  
  // 1. Filter and collect valid files
  zip.forEach((relativePath, fileEntry) => {
    if (!fileEntry.dir && !relativePath.includes("__MACOSX") && !relativePath.includes(".DS_Store")) {
      rawFiles.push({ path: relativePath, entry: fileEntry });
    }
  });

  // 2. Detect common prefix (root folder)
  let commonPrefix = "";
  if (rawFiles.length > 0) {
    const sortedPaths = rawFiles.map(f => f.path).sort();
    const first = sortedPaths[0];
    const last = sortedPaths[sortedPaths.length - 1];
    
    let i = 0;
    while (i < first.length && first.charAt(i) === last.charAt(i)) {
      i++;
    }
    
    const prefix = first.substring(0, i);
    const lastSlash = prefix.lastIndexOf("/");
    if (lastSlash !== -1) {
      const potentialPrefix = prefix.substring(0, lastSlash + 1);
      if (rawFiles.every(f => f.path.startsWith(potentialPrefix))) {
        commonPrefix = potentialPrefix;
      }
    }
  }

  // 3. Process files (strip prefix)
  const files: { path: string; size: number; entry: JSZip.JSZipObject }[] = [];
  let totalSize = 0;
  let hasIndexHtml = false;
  let hasPackageJson = false;

  for (const { path, entry } of rawFiles) {
    const finalPath = commonPrefix ? path.substring(commonPrefix.length) : path;
    // @ts-ignore
    const size = entry._data?.uncompressedSize || 0;
    
    files.push({ path: finalPath, size, entry });
    totalSize += size;

    if (finalPath === "index.html") hasIndexHtml = true;
    if (finalPath === "package.json") hasPackageJson = true;
  }

  let projectType: ZipAnalysis["projectType"] = "Unknown";
  if (hasIndexHtml) projectType = "Static Website";
  else if (hasPackageJson) projectType = "Node.js Project";

  return {
    zip,
    fileCount: files.length,
    totalSize,
    projectType,
    files
  };
}

export async function deployZipToGitHub(
  token: string,
  repoName: string,
  description: string,
  isPrivate: boolean,
  analysis: ZipAnalysis,
  onStatus: StatusCallback
) {
  const octokit = new Octokit({ auth: token });
  let owner = "";

  try {
    // 1. Authenticate and get user info
    onStatus({ step: "Authenticating...", type: "info" });
    const { data: user } = await octokit.rest.users.getAuthenticated();
    owner = user.login;
    onStatus({ step: `Authenticated as ${owner}`, type: "success" });

    // 2. Create Repository
    onStatus({ step: `Creating repository "${repoName}"...`, type: "info" });
    try {
      await octokit.rest.repos.createForAuthenticatedUser({
        name: repoName,
        description: description || "Deployed via ZipToRepo",
        private: isPrivate,
        auto_init: true, // Initialize with README to have a base commit
      });
      onStatus({ step: "Repository created successfully.", type: "success" });
    } catch (error: any) {
      if (error.status === 422) {
        throw new Error(`Repository "${repoName}" already exists.`);
      }
      throw error;
    }

    // 3. Process Files from Analysis
    onStatus({ step: "Preparing files from analysis...", type: "info" });
    
    const filesToUpload: { path: string; content: Uint8Array; mode: "100644" }[] = [];
    
    for (const file of analysis.files) {
      const content = await file.entry.async("uint8array");
      filesToUpload.push({
        path: file.path,
        content: content,
        mode: "100644",
      });
    }

    onStatus({ step: `Prepared ${filesToUpload.length} files for upload.`, type: "info" });

    // 4. Get the latest commit SHA (from auto_init)
    const { data: refData } = await octokit.rest.git.getRef({
      owner,
      repo: repoName,
      ref: "heads/main",
    });
    const latestCommitSha = refData.object.sha;

    // 5. Create Blobs (in batches to avoid rate limits)
    onStatus({ step: "Uploading files (creating blobs)...", type: "info" });
    
    const treeItems: { path: string; mode: "100644" | "100755" | "040000" | "160000" | "120000"; type: "blob"; sha: string }[] = [];
    
    // Batch size for blob creation
    const BATCH_SIZE = 5;
    for (let i = 0; i < filesToUpload.length; i += BATCH_SIZE) {
      const batch = filesToUpload.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map(async (file) => {
        // Convert Uint8Array to Base64 string
        const contentBase64 = Buffer.from(file.content).toString("base64");
        
        const { data: blob } = await octokit.rest.git.createBlob({
          owner,
          repo: repoName,
          content: contentBase64,
          encoding: "base64",
        });
        
        treeItems.push({
          path: file.path,
          mode: file.mode,
          type: "blob",
          sha: blob.sha,
        });
      }));
      
      onStatus({ 
        step: `Uploaded ${Math.min(i + BATCH_SIZE, filesToUpload.length)}/${filesToUpload.length} files...`, 
        type: "info" 
      });
    }

    // 6. Create Tree
    onStatus({ step: "Creating file tree...", type: "info" });
    const { data: tree } = await octokit.rest.git.createTree({
      owner,
      repo: repoName,
      base_tree: latestCommitSha,
      tree: treeItems,
    });

    // 7. Create Commit
    onStatus({ step: "Creating commit...", type: "info" });
    const { data: newCommit } = await octokit.rest.git.createCommit({
      owner,
      repo: repoName,
      message: `Deploy project via ZipToRepo`,
      tree: tree.sha,
      parents: [latestCommitSha],
    });

    // 8. Update Reference
    onStatus({ step: "Updating repository reference...", type: "info" });
    await octokit.rest.git.updateRef({
      owner,
      repo: repoName,
      ref: "heads/main",
      sha: newCommit.sha,
    });

    onStatus({ 
      step: "Deployment complete!", 
      details: `https://github.com/${owner}/${repoName}`,
      type: "success" 
    });

    return `https://github.com/${owner}/${repoName}`;

  } catch (error: any) {
    console.error("Deployment failed:", error);
    onStatus({ 
      step: "Deployment failed", 
      details: error.message || "Unknown error occurred", 
      type: "error" 
    });
    throw error;
  }
}
