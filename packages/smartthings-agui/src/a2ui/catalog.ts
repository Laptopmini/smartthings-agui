import { createCatalog } from "@copilotkit/a2ui-renderer";
import { definitions } from "./definitions.js";
import { renderers } from "./renderers.js";
import { CATALOG_ID } from "./surfaces.js";

// No basic catalog: these surfaces only use the three components above, and
// the agent never sees the catalog anyway.
export const catalog = createCatalog(definitions, renderers, { catalogId: CATALOG_ID });
