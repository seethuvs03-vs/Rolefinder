import { build } from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";

await mkdir("dist", { recursive: true });
await Promise.all([
  build({ entryPoints: ["static/app.js"], bundle: true, format: "esm", outdir: "dist" }),
  copyFile("static/index.html", "dist/index.html"),
  copyFile("static/style.css", "dist/style.css"),
  copyFile("node_modules/pdfjs-dist/build/pdf.worker.min.mjs", "dist/pdf.worker.min.mjs")
]);
