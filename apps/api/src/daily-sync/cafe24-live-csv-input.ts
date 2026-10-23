import {CAFE24_OPTION_COMPOSITION_LIMIT} from "./cafe24-option-projection";
/** The reviewed 11-column transport orders optionName at index four. */
export function isSafeCafe24LiveCsvCell(cell:unknown,columnIndex:number):cell is string {
  return typeof cell==="string" && cell.length<=(columnIndex===4?CAFE24_OPTION_COMPOSITION_LIMIT:512) && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(cell);
}
