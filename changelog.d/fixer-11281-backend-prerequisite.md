### Fixed

- **Type-aware analysis uses a source-qualified TypeScript backend.** The
  `7.0.2-upstroke.1` backend enables `noEmit` for inferred projects, preserving
  structural diagnostics while allowing extension-bearing imports. Its signed
  payload is selected consistently for one-shot, persistent, and mutant
  analysis, and the native transport preserves the manifest locator.
