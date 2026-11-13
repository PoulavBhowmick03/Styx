import { defineConfig } from 'vite';
// Fonts and logo are shared by every page on styxco.xyz (../site).
export default defineConfig({define:{global:'globalThis'},publicDir:'../site/public'});
