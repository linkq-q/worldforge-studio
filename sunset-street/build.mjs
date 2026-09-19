import {build} from 'vite';
import {copyFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('.',import.meta.url));
await build({configFile:false,root,base:'./',build:{outDir:'../dist/sunset-street',emptyOutDir:false}});
await copyFile(new URL('./METHOD.md',import.meta.url),new URL('../dist/sunset-street/METHOD.md',import.meta.url));
