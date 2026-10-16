/** Types for check-no-mocks.mjs, so its tests can import it. */
export declare const SCANNED: readonly string[];
export declare function importsOf(source: string): string[];
export declare function mockImports(source: string): string[];
export declare function findMockImports(dirs?: readonly string[], root?: string): string[];
