#!/usr/bin/env bun
import plugin from "bun-plugin-tailwind";

const result = await Bun.build({
  entrypoints: ["./src/cli.ts"],
  plugins: [plugin],
  minify: !!process.env.CI,
  ...(process.env.BUILD_TARGET ? { target: process.env.BUILD_TARGET as import("bun").Target } : {}),
  compile: {
    outfile: "./cmux-hub",
  },
});

if (!result.success) {
  console.error("Build failed:");
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

console.log("Built: cmux-hub");
