import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const scopeSchema = z.enum([
  "last-turn", "uncommitted", "unstaged", "staged", "committed", "branch",
]);
export const fileSchema = z.object({
  path: z.string(),
  patch: z.string(),
  preview: z.string().nullable(),
  truncated: z.boolean(),
});
export const hostContract = defineRpcContract({
  snapshot: {
    input: z.object({
      directory: z.string(),
      scope: scopeSchema,
      baseBranch: z.string().nullable(),
      paths: z.array(z.string()).optional(),
    }).strict(),
    output: z.object({ files: z.array(fileSchema), message: z.string().nullable() }).strict(),
  },
});
export const rpcContract = defineRpcContract({
  changes: {
    input: z.object({ threadId: z.string().regex(/^thr_[A-Za-z0-9]+$/u), scope: scopeSchema }).strict(),
    output: z.object({ files: z.array(fileSchema), message: z.string().nullable() }).strict(),
  },
});
export type Scope = z.infer<typeof scopeSchema>;
export type DiffFile = z.infer<typeof fileSchema>;
