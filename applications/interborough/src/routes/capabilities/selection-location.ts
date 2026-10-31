/** Where a ListDetail on the Capabilities page keeps its open item: the address. */
import { routerSelectionLocationFor } from '../../lib/router-selection-location.ts';

/** A selection that reads and writes one parameter of the Capabilities address. */
export const routerSelectionLocation = routerSelectionLocationFor('/capabilities');
