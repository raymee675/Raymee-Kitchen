import React from "react";
import { createRoot } from "react-dom/client";
import "../../app/globals.css";
import Kitchen from "../../app/kitchen";
import Enrollment from "./register";

const root = document.getElementById("root");
if (!root) throw new Error("アプリの表示先がありません。");
createRoot(root).render(<React.StrictMode>
  {window.location.pathname === "/register" ? <Enrollment /> : <Kitchen />}
</React.StrictMode>);
