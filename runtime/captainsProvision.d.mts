export function provisionCaptainsFilesystem(input: {
  voltId: string;
  path: string;
  cwd?: string;
  title: string;
  description?: string;
  voltType: string;
  modules?: string[];
  environment: { id: string; title: string; description?: string };
  project?: { id: string; title: string; description?: string } | null;
  mission?: { id: string; title: string; description?: string } | null;
  creationRequestId?: string;
  krakenRunId?: string;
  createdAt?: string;
  updatedAt?: string;
  dryRun?: boolean;
}): Promise<{
  voltId: string;
  written: string[];
  preserved: string[];
  dryRun: boolean;
  files: string[];
  templateVersion: string;
}>;
