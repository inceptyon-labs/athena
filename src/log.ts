const stamp = () => new Date().toISOString();
export const log = (message: string) => console.log(`${stamp()} ${message}`);
export const warn = (message: string) => console.warn(`${stamp()} WARN ${message}`);
