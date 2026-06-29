import { useState } from "react";

type Props = {
  src: string;
  fallback: string;
};

export function ModIconImage({ src, fallback }: Props) {
  const [failedSrc, setFailedSrc] = useState("");
  const activeSrc = src && failedSrc !== src ? src : "";

  if (!activeSrc) {
    return <span className="modsWorkspaceFallback">{fallback}</span>;
  }

  return <img src={activeSrc} alt="" onError={() => setFailedSrc(activeSrc)} />;
}
