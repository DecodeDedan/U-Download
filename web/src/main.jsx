import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./App.css";
// After App.css so Tailwind's reset never overrides the v4 components.
import "./styles/ui.css";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
