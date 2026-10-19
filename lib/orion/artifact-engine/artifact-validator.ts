import type { ValidationResult, VFSMap, FrameworkDefinition } from './types';

export class ArtifactValidator {
  validate(vfs: VFSMap, framework: FrameworkDefinition): ValidationResult {
    const frameworkResult = framework.validateStructure(vfs);
    const warnings: string[] = [...frameworkResult.warnings];
    const errors: string[] = [...frameworkResult.errors];

    if (vfs.size === 0) {
      errors.push('No files in VFS');
    }

    for (const [path, file] of vfs.entries()) {
      if (!file.content.trim()) {
        warnings.push(`Empty file: ${path}`);
      }
    }

    this.validateTailwindSetup(vfs, warnings);

    return {
      valid: errors.length === 0,
      warnings,
      errors,
    };
  }

  private validateTailwindSetup(vfs: VFSMap, warnings: string[]): void {
    const packageFile = vfs.get('package.json');
    let tailwindMajor: number | null = null;

    if (packageFile) {
      try {
        const packageJson = JSON.parse(packageFile.content);
        const version =
          packageJson.devDependencies?.tailwindcss ?? packageJson.dependencies?.tailwindcss;
        const majorMatch = typeof version === 'string' ? version.match(/\d+/) : null;
        if (majorMatch) tailwindMajor = Number(majorMatch[0]);
      } catch {
        // Package structure validation is handled by the framework validator.
      }
    }

    const configFile = [...vfs.entries()].find(([path]) =>
      /^tailwind\.config\.[cm]?[jt]s$/.test(path),
    )?.[1];

    if (tailwindMajor === 3) {
      if (!configFile) {
        warnings.push('Tailwind CSS v3 requires a tailwind.config file with content globs.');
      } else if (
        !/\bcontent\s*:\s*\[[\s\S]*?\S[\s\S]*?\]/.test(configFile.content) ||
        /content\s*:\s*\[\s*\]/.test(configFile.content)
      ) {
        warnings.push('Tailwind CSS v3 config is missing non-empty content globs.');
      }
    }

    const declaredThemeTokens = new Set<string>();
    if (configFile) {
      const tokenPattern = /["']?([a-zA-Z][\w-]*)["']?\s*:/g;
      for (const match of configFile.content.matchAll(tokenPattern)) {
        declaredThemeTokens.add(match[1].toLowerCase());
      }
    }

    for (const [path, file] of vfs.entries()) {
      if (!/\.(?:css|pcss)$/.test(path)) continue;

      for (const applyMatch of file.content.matchAll(/@apply\s+([^;]+);/g)) {
        const utilities = applyMatch[1].trim().split(/\s+/);
        for (const utility of utilities) {
          const semanticColor = utility.match(/^(?:bg|text|border|ring)-([a-z][\w-]*)$/);
          const token = semanticColor?.[1];
          if (
            token &&
            ['light', 'dark', 'primary', 'secondary', 'accent', 'background', 'foreground',
              'muted', 'destructive', 'card', 'popover'].includes(token) &&
            !declaredThemeTokens.has(token)
          ) {
            warnings.push(
              `${path} uses @apply ${utility}, but "${token}" is not declared in the Tailwind config. Define the theme token or use a built-in utility.`,
            );
          }
        }
      }
    }
  }
}
