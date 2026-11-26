declare module 'virtual:ajwf-world' {
  import type { StaticWorld } from './data/staticWorld';
  const world: StaticWorld;
  export default world;
}

declare module 'virtual:ajwf-ui-en' {
  const messages: Record<string, string>;
  export default messages;
}

declare module 'virtual:ajwf-catalog/*' {
  const messages: Record<string, string>;
  export default messages;
}
