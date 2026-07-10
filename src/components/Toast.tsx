import React, { createContext, useCallback, useContext, useRef, useState } from "react";

type ToastKind = "info" | "success";

type ToastState = { message: string; kind: ToastKind } | null;

type ToastContextValue = {
  showToast: (message: string, kind?: ToastKind) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toast, setToast] = useState<ToastState>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((message: string, kind: ToastKind = "info") => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setToast({ message, kind });
    timerRef.current = setTimeout(() => setToast(null), 3500);
  }, []);

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[100]">
          <div
            className={`px-4 py-2 rounded-md shadow-lg border text-sm font-medium ${
              toast.kind === "success"
                ? "bg-[#1a3329] border-[#238636] text-[#3fb950]"
                : "bg-[#21262d] border-[#30363d] text-[#c9d1d9]"
            }`}
          >
            {toast.message}
          </div>
        </div>
      )}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}
