/**
 * Stands in for every other `@amazon-devices/*` package. The on-screen app
 * does not use them; a few shared files name one in a lazy `import()` that
 * only ever runs inside a Vega background process. The bundler still has to
 * resolve the name to something, and this is the something: a module with
 * nothing in it, so reaching for a Vega API on Fire OS fails where it is
 * reached rather than quietly doing nothing.
 */
export {};
