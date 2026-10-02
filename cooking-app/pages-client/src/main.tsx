import React from "react";
import { createRoot } from "react-dom/client";
import "../../app/globals.css";
import { PagesKitchen } from "../../app/kitchen";

const root = document.getElementById("root");
if (!root) throw new Error("アプリの表示先がありません。");

createRoot(root).render(
  <React.StrictMode>
    <PagesKitchen />
  </React.StrictMode>,
);
