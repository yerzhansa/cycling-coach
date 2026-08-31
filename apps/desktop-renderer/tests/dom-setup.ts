import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach } from "vitest";
import { installDialog } from "./dialog";
import { installMatchMedia } from "./matchmedia";

installDialog();

beforeEach(() => {
  installMatchMedia();
});

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("style");
  document.documentElement.removeAttribute("data-theme");
  localStorage.clear();
});
