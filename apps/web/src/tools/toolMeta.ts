import type { ToolId } from '../app/store';

/** Tool order, labels and number-key shortcuts: the single source for the toolbar and the keyboard. */
export const TOOL_META: readonly { id: ToolId; label: string; key: string }[] = [
  { id: 'select', label: '선택', key: '1' },
  { id: 'road', label: '도로', key: '2' },
  { id: 'building', label: '건물', key: '3' },
  { id: 'bulldoze', label: '철거', key: '4' },
  { id: 'busLine', label: '버스', key: '5' },
  { id: 'closure', label: '폐쇄', key: '6' },
  { id: 'parcel', label: '필지', key: '7' },
  { id: 'street', label: '교통 시설', key: '8' },
  { id: 'zoning', label: '조닝', key: '9' },
];
