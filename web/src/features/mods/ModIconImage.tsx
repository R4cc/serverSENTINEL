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

  // A search result or a full mod list renders dozens of these at once, each proxied through the
  // panel's own origin — so without deferring they contend with the API calls the page is waiting
  // on. The stylesheet fixes the box, so nothing shifts when one arrives late.
  return <img src={activeSrc} alt="" loading="lazy" decoding="async" onError={() => setFailedSrc(activeSrc)} />;
}
