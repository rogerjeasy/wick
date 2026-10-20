/** Types for web-vendor.mjs, so its test can import it. */
export declare const VENDOR_DIR: string;
export declare const ICONS: Readonly<Record<string, string>>;
export declare function vendorFiles(): Promise<Map<string, string | Buffer>>;
export declare function vendoredNow(dir?: string): Map<string, Buffer>;
export declare function main(): Promise<void>;
