/** Types for family-vendor.mjs, so its test can import it. */
export declare const VENDOR_DIR: string;
export declare const ICON_NAMES: readonly string[];
export declare const FONT_FAMILY: string;
export declare function vendorFiles(): Promise<Map<string, Buffer>>;
