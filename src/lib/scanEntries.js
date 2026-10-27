// Individual adds, bulk adds and CSV exports all use the reviewed row state.
export function getSelectedDetectionEntries(detections, selectedIndices) {
  return [...selectedIndices].map((index) => detections[index]?.entry).filter(Boolean);
}
