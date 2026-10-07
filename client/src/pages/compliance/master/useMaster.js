import { useCallback, useEffect, useState } from 'react';
import { capi, errSync } from '../complianceApi';

// Loads Company Master, Compliance Master and Applicability (GET /api/compliance/master)
export default function useMaster(refreshKey) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const reload = useCallback(async () => {
    setError('');
    try { setData(await capi.master()); } catch (e) { setError(errSync(e)); }
  }, []);
  useEffect(() => { reload(); }, [reload, refreshKey]);
  return { data, error, reload };
}
