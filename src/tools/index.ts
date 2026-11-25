import { desktopTools } from './desktop.ts';
import { downloadTools } from './download.ts';
import { filesystemTools } from './filesystem.ts';
import { scriptTools } from './scripts.ts';
import { systemTools } from './system.ts';
import type { Tool } from './registry.ts';

export const defaultTools: Tool[] = [...filesystemTools, ...scriptTools, ...systemTools, ...desktopTools, ...downloadTools];
