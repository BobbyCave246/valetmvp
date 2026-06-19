// Deep links from the admin supervisor console into field staff apps.

function warehouseFieldUrl({ mode, binBarcode }) {
  const modeMap = { store: 'putaway', scanout: 'pullout' };
  const params = new URLSearchParams();
  const whMode = modeMap[mode];
  if (whMode) params.set('mode', whMode);
  if (binBarcode) params.set('bin', binBarcode);
  const qs = params.toString();
  return qs ? `/warehouse/?${qs}` : '/warehouse/';
}

function driverFieldUrl({ jobId } = {}) {
  return jobId ? `/driver/?job=${encodeURIComponent(jobId)}` : '/driver/';
}
