import React from "react";
import { createRoot } from "react-dom/client";
import "@meridian/design/css";
import "./app.css";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
