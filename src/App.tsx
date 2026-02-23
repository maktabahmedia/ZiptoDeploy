import React, { useState, useCallback } from "react";
import { useDropzone, type DropzoneOptions } from "react-dropzone";
import { motion, AnimatePresence } from "motion/react";
import JSZip from "jszip";
import { 
  Github, 
  Upload, 
  CheckCircle, 
  AlertCircle, 
  Loader2, 
  ArrowRight, 
  FolderGit2, 
  FileArchive,
  FileCode,
  Box
} from "lucide-react";
import { deployZipToGitHub, analyzeZip, type DeployStatus, type ZipAnalysis } from "./lib/github";
import { cn } from "./lib/utils";

// --- Components ---

const StepIndicator = ({ currentStep }: { currentStep: number }) => {
  const steps = [
    { id: 1, label: "Token" },
    { id: 2, label: "Repo" },
    { id: 3, label: "Upload" },
    { id: 4, label: "Deploy" },
  ];

  return (
    <div className="flex items-center justify-center mb-8 w-full max-w-md mx-auto">
      {steps.map((step, index) => (
        <div key={step.id} className="flex items-center">
          <div className="relative flex flex-col items-center">
            <div
              className={cn(
                "w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium transition-colors duration-300 z-10",
                currentStep >= step.id
                  ? "bg-black text-white"
                  : "bg-gray-200 text-gray-500"
              )}
            >
              {currentStep > step.id ? <CheckCircle className="w-5 h-5" /> : step.id}
            </div>
            <span className="absolute -bottom-6 text-xs font-medium text-gray-500">
              {step.label}
            </span>
          </div>
          {index < steps.length - 1 && (
            <div
              className={cn(
                "w-12 h-0.5 mx-2 transition-colors duration-300",
                currentStep > step.id ? "bg-black" : "bg-gray-200"
              )}
            />
          )}
        </div>
      ))}
    </div>
  );
};

const Card = ({ children, className }: { children: React.ReactNode; className?: string; key?: React.Key }) => (
  <motion.div
    initial={{ opacity: 0, y: 20 }}
    animate={{ opacity: 1, y: 0 }}
    exit={{ opacity: 0, y: -20 }}
    className={cn("bg-white rounded-2xl shadow-sm border border-gray-100 p-8 w-full max-w-md mx-auto", className)}
  >
    {children}
  </motion.div>
);

const Button = ({ 
  children, 
  onClick, 
  disabled, 
  variant = "primary", 
  className 
}: { 
  children: React.ReactNode; 
  onClick?: () => void; 
  disabled?: boolean; 
  variant?: "primary" | "secondary"; 
  className?: string;
}) => (
  <button
    onClick={onClick}
    disabled={disabled}
    className={cn(
      "w-full py-3 px-4 rounded-xl font-medium transition-all duration-200 flex items-center justify-center gap-2",
      variant === "primary" 
        ? "bg-black text-white hover:bg-gray-800 disabled:bg-gray-300 disabled:cursor-not-allowed"
        : "bg-gray-100 text-gray-900 hover:bg-gray-200",
      className
    )}
  >
    {children}
  </button>
);

const Input = ({ 
  label, 
  value, 
  onChange, 
  placeholder, 
  type = "text",
  helperText
}: { 
  label: string; 
  value: string; 
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void; 
  placeholder?: string; 
  type?: string;
  helperText?: React.ReactNode;
}) => (
  <div className="mb-4">
    <label className="block text-sm font-medium text-gray-700 mb-1.5">{label}</label>
    <input
      type={type}
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      className="w-full px-4 py-2.5 rounded-xl border border-gray-200 focus:border-black focus:ring-1 focus:ring-black outline-none transition-all"
    />
    {helperText && <p className="mt-1.5 text-xs text-gray-500">{helperText}</p>}
  </div>
);

// --- Main App ---

export default function App() {
  const [step, setStep] = useState(1);
  const [token, setToken] = useState("");
  const [repoName, setRepoName] = useState("");
  const [description, setDescription] = useState("");
  const [isPrivate, setIsPrivate] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [analysis, setAnalysis] = useState<ZipAnalysis | null>(null);
  const [logs, setLogs] = useState<DeployStatus[]>([]);
  const [isDeploying, setIsDeploying] = useState(false);
  const [deployedUrl, setDeployedUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);

  const onDrop = useCallback(async (acceptedFiles: File[]) => {
    setValidationError(null);
    setFile(null);
    setAnalysis(null);

    if (acceptedFiles.length > 0) {
      const selectedFile = acceptedFiles[0];
      if (!selectedFile.name.endsWith(".zip")) {
        setValidationError("Please upload a valid .zip file");
        return;
      }

      try {
        const result = await analyzeZip(selectedFile);
        
        if (result.projectType === "Unknown") {
           // We can still allow it, but maybe warn? 
           // For now, let's just accept it but show "Unknown" type.
           // Or strictly enforce index.html/package.json if we want.
           // The previous validation logic was:
           // if (!hasIndexHtml && !hasPackageJson) ...
           
           // Let's keep the strict check for now as per previous request logic
           // But analyzeZip already determines projectType based on those files.
           // If projectType is Unknown, it means neither was found (or logic in analyzeZip needs check).
           
           // Re-implement strict check based on analysis:
           const hasIndex = result.files.some(f => f.path === "index.html" || f.path.match(/^[^/]+\/index\.html$/));
           const hasPackage = result.files.some(f => f.path === "package.json" || f.path.match(/^[^/]+\/package\.json$/));
           
           if (!hasIndex && !hasPackage) {
             setValidationError("Invalid ZIP: Must contain 'index.html' or 'package.json' at the root.");
             return;
           }
        }

        setAnalysis(result);
        setFile(selectedFile);
      } catch (err) {
        console.error(err);
        setValidationError("Failed to read or analyze ZIP file.");
      }
    }
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({ 
    onDrop,
    accept: { 'application/zip': ['.zip'] },
    maxFiles: 1,
    multiple: false
  } as any);

  const handleDeploy = async () => {
    if (!file || !token || !repoName || !analysis) return;

    setStep(4);
    setIsDeploying(true);
    setLogs([]);
    setError(null);

    try {
      const url = await deployZipToGitHub(
        token,
        repoName,
        description,
        isPrivate,
        analysis,
        (status) => {
          setLogs((prev) => [...prev, status]);
        }
      );
      setDeployedUrl(url);
      setStep(5);
    } catch (err: any) {
      setError(err.message || "Deployment failed");
      setLogs((prev) => [...prev, { step: "Failed", details: err.message, type: "error" }]);
    } finally {
      setIsDeploying(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 font-sans py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-3xl mx-auto text-center mb-12">
        <h1 className="text-4xl font-bold tracking-tight text-gray-900 sm:text-5xl mb-4">
          Zip to Repo
        </h1>
        <p className="text-lg text-gray-600">
          Deploy your project to GitHub in seconds. Just upload a ZIP.
        </p>
      </div>

      <StepIndicator currentStep={step} />

      <AnimatePresence mode="wait">
        {step === 1 && (
          <Card key="step1">
            <div className="flex flex-col items-center mb-6">
              <div className="w-12 h-12 bg-gray-100 rounded-full flex items-center justify-center mb-4">
                <Github className="w-6 h-6" />
              </div>
              <h2 className="text-xl font-semibold">Connect GitHub</h2>
              <p className="text-sm text-gray-500 mt-1">Enter your Personal Access Token</p>
            </div>
            
            <Input
              label="Personal Access Token"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              type="password"
              placeholder="ghp_..."
              helperText={
                <span>
                  Create a token with <code>repo</code> scope at{" "}
                  <a 
                    href="https://github.com/settings/tokens" 
                    target="_blank" 
                    rel="noreferrer"
                    className="text-blue-600 hover:underline"
                  >
                    GitHub Settings
                  </a>
                </span>
              }
            />

            <Button 
              onClick={() => setStep(2)} 
              disabled={!token.startsWith("ghp_") && !token.startsWith("github_pat_")}
              className="mt-4"
            >
              Next Step <ArrowRight className="w-4 h-4" />
            </Button>
          </Card>
        )}

        {step === 2 && (
          <Card key="step2">
            <div className="flex flex-col items-center mb-6">
              <div className="w-12 h-12 bg-gray-100 rounded-full flex items-center justify-center mb-4">
                <FolderGit2 className="w-6 h-6" />
              </div>
              <h2 className="text-xl font-semibold">Repository Details</h2>
              <p className="text-sm text-gray-500 mt-1">Where should we push your code?</p>
            </div>

            <Input
              label="Repository Name"
              value={repoName}
              onChange={(e) => setRepoName(e.target.value)}
              placeholder="my-awesome-project"
            />
            
            <Input
              label="Description (Optional)"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="A brief description of your project"
            />

            <div className="flex items-center mb-6">
              <input
                id="private-repo"
                type="checkbox"
                checked={isPrivate}
                onChange={(e) => setIsPrivate(e.target.checked)}
                className="h-4 w-4 text-black focus:ring-black border-gray-300 rounded"
              />
              <label htmlFor="private-repo" className="ml-2 block text-sm text-gray-900">
                Make this repository private
              </label>
            </div>

            <div className="flex gap-3">
              <Button variant="secondary" onClick={() => setStep(1)}>Back</Button>
              <Button onClick={() => setStep(3)} disabled={!repoName}>Next Step <ArrowRight className="w-4 h-4" /></Button>
            </div>
          </Card>
        )}

        {step === 3 && (
          <Card key="step3">
            <div className="flex flex-col items-center mb-6">
              <div className="w-12 h-12 bg-gray-100 rounded-full flex items-center justify-center mb-4">
                <FileArchive className="w-6 h-6" />
              </div>
              <h2 className="text-xl font-semibold">Upload Project</h2>
              <p className="text-sm text-gray-500 mt-1">Upload your project as a .zip file</p>
            </div>

            <div
              {...getRootProps()}
              className={cn(
                "border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors mb-6",
                isDragActive ? "border-black bg-gray-50" : "border-gray-200 hover:border-gray-300",
                file ? "bg-green-50 border-green-200" : ""
              )}
            >
              <input {...getInputProps()} />
              {file ? (
                <div className="flex flex-col items-center text-green-700">
                  <CheckCircle className="w-8 h-8 mb-2" />
                  <p className="font-medium">{file.name}</p>
                  <p className="text-xs mt-1">{(file.size / 1024 / 1024).toFixed(2)} MB</p>
                </div>
              ) : (
                <div className="flex flex-col items-center text-gray-500">
                  <Upload className="w-8 h-8 mb-2" />
                  <p className="font-medium">Drag & drop your ZIP here</p>
                  <p className="text-xs mt-1">or click to browse</p>
                </div>
              )}
            </div>

            {validationError && (
              <div className="mb-6 p-4 bg-red-50 text-red-700 rounded-xl flex items-start gap-3 text-sm">
                <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5" />
                <div>
                  <p className="font-medium">Validation Error</p>
                  <p>{validationError}</p>
                </div>
              </div>
            )}

            {analysis && (
              <div className="mb-6 bg-gray-50 rounded-xl p-4 border border-gray-100">
                <h3 className="text-sm font-semibold text-gray-900 mb-3 flex items-center gap-2">
                  <FileCode className="w-4 h-4" /> Analysis Result
                </h3>
                <div className="grid grid-cols-2 gap-4 mb-4">
                  <div className="bg-white p-3 rounded-lg border border-gray-100 shadow-sm">
                    <p className="text-xs text-gray-500 mb-1">Project Type</p>
                    <p className="font-medium text-sm flex items-center gap-1.5">
                      <Box className="w-3.5 h-3.5 text-blue-500" />
                      {analysis.projectType}
                    </p>
                  </div>
                  <div className="bg-white p-3 rounded-lg border border-gray-100 shadow-sm">
                    <p className="text-xs text-gray-500 mb-1">Total Files</p>
                    <p className="font-medium text-sm">{analysis.fileCount}</p>
                  </div>
                </div>
                
                <div className="bg-white rounded-lg border border-gray-100 shadow-sm overflow-hidden">
                  <div className="px-3 py-2 bg-gray-50 border-b border-gray-100 text-xs font-medium text-gray-500">
                    Extracted Files Preview
                  </div>
                  <div className="max-h-32 overflow-y-auto p-2 space-y-1">
                    {analysis.files.slice(0, 20).map((f, i) => (
                      <div key={i} className="flex justify-between text-xs text-gray-600">
                        <span className="truncate max-w-[200px]">{f.path}</span>
                        <span className="text-gray-400">{(f.size / 1024).toFixed(1)} KB</span>
                      </div>
                    ))}
                    {analysis.files.length > 20 && (
                      <div className="text-xs text-gray-400 italic text-center pt-1">
                        + {analysis.files.length - 20} more files...
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            <div className="flex gap-3">
              <Button variant="secondary" onClick={() => setStep(2)}>Back</Button>
              <Button onClick={handleDeploy} disabled={!file}>
                Deploy to GitHub <ArrowRight className="w-4 h-4" />
              </Button>
            </div>
          </Card>
        )}

        {(step === 4 || step === 5) && (
          <Card key="step4" className="max-w-xl">
            <div className="flex flex-col items-center mb-6">
              {step === 5 ? (
                <div className="w-16 h-16 bg-green-100 text-green-600 rounded-full flex items-center justify-center mb-4">
                  <CheckCircle className="w-8 h-8" />
                </div>
              ) : (
                <div className="w-16 h-16 bg-blue-50 text-blue-600 rounded-full flex items-center justify-center mb-4">
                  <Loader2 className="w-8 h-8 animate-spin" />
                </div>
              )}
              <h2 className="text-xl font-semibold">
                {step === 5 ? "Deployment Successful!" : "Deploying..."}
              </h2>
              {step === 5 && deployedUrl && (
                <div className="flex flex-col items-center">
                  <a 
                    href={deployedUrl} 
                    target="_blank" 
                    rel="noreferrer"
                    className="text-blue-600 hover:underline mt-2 font-medium"
                  >
                    View Repository
                  </a>
                  <p className="text-xs text-gray-500 mt-4 max-w-xs text-center">
                    Tip: To host this website live, go to your repository <strong>Settings &gt; Pages</strong> and select the <strong>main</strong> branch.
                  </p>
                </div>
              )}
            </div>

            <div className="bg-gray-900 rounded-xl p-4 font-mono text-xs text-gray-300 h-64 overflow-y-auto space-y-2">
              {logs.map((log, i) => (
                <div key={i} className={cn(
                  "flex gap-2",
                  log.type === "error" ? "text-red-400" : 
                  log.type === "success" ? "text-green-400" : "text-gray-300"
                )}>
                  <span className="opacity-50">[{new Date().toLocaleTimeString()}]</span>
                  <span>
                    {log.step}
                    {log.details && (
                      <span className="block ml-4 opacity-70 mt-1">{log.details}</span>
                    )}
                  </span>
                </div>
              ))}
              {isDeploying && (
                <div className="animate-pulse text-gray-500">...</div>
              )}
            </div>
            
            {step === 5 && (
              <Button onClick={() => { setStep(1); setLogs([]); setFile(null); }} className="mt-6">
                Deploy Another
              </Button>
            )}
            
            {error && (
               <Button onClick={() => setStep(3)} variant="secondary" className="mt-6 bg-red-50 text-red-600 hover:bg-red-100">
                 Try Again
               </Button>
            )}
          </Card>
        )}
      </AnimatePresence>
    </div>
  );
}
