import React from "react";
import ReactDOM from "react-dom/client";
import InvestigationWorkbench from "./InvestigationWorkbench";
import "@/i18n";
import "@/App.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <InvestigationWorkbench />
  </React.StrictMode>,
);
