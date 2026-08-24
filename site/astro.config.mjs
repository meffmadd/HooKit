// @ts-check
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';
import mdx from '@astrojs/mdx';
import { unified } from '@astrojs/markdown-remark';
import {
  rehypeCode,
  remarkCodeTab,
  remarkHeading,
  remarkNpm,
  remarkStructure,
} from 'fumadocs-core/mdx-plugins';
import { rehypeGlossaryTooltips, remarkGlossaryLinks } from './src/glossary-link';

const remarkPlugins = [
  // Canonical computed form: `[pluginFactory, options]`. Registering the
  // factory (not an invoked transformer) is what lets the MDX remark
  // pipeline call it per file — a live transformer would be mistaken for a
  // plugin function and silently dropped.
  [remarkGlossaryLinks, { oncePerPage: true }],
  remarkHeading,
  remarkCodeTab,
  remarkNpm,
  [remarkStructure, { exportAs: 'structuredData' }],
];
const rehypePlugins = [rehypeGlossaryTooltips, rehypeCode];

const pagesBasePath = '/HooKit';
const pagesPath = (path) => `${pagesBasePath}${path}`;

export default defineConfig({
  site: 'https://meffmadd.github.io',
  base: pagesBasePath,
  redirects: {
    '/reference/action': pagesPath('/reference/configuration/action'),
    '/reference/filter': pagesPath('/reference/configuration/filter'),
    '/reference/hook-result': pagesPath('/reference/events'),
    '/reference/configuration/hook-result': pagesPath('/reference/events'),
    '/reference/presets-sources': pagesPath('/reference/configuration/presets-sources'),
  },
  markdown: {
    processor: unified({
      syntaxHighlight: false,
      remarkPlugins,
      rehypePlugins,
    }),
  },
  integrations: [
    react(),
    mdx({
      extendMarkdownConfig: true,
      syntaxHighlight: false,
    }),
  ],
  vite: {
    plugins: [tailwindcss()],
  },
});
