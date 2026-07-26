import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import App from "./App";
import { readStoredDemoMode } from "./app/appConfig";
import { loadDemoFixtures } from "./demoRuntime";
import { applyStandaloneViewport } from "./standaloneViewport";

applyStandaloneViewport();

function render() {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>
  );
}

// A stored demo session makes App read fixtures during its first render, so the
// lazily loaded chunk has to be in place before mounting. Ordinary sessions never
// reach this branch and never download the chunk.
if (readStoredDemoMode()) {
  void loadDemoFixtures().finally(render);
} else {
  render();
}
