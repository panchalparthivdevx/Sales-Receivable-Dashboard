import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import axios from 'axios';

const BASE = `/api`;

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user,        setUser]        = useState(null);
  const [loading,     setLoading]     = useState(true);   // checking stored token
  const [token,       setToken]       = useState(() => localStorage.getItem('da_token'));

  // Attach token to all axios requests
  useEffect(() => {
    const reqId = axios.interceptors.request.use(cfg => {
      const t = localStorage.getItem('da_token');
      if (t) cfg.headers = { ...cfg.headers, Authorization: `Bearer ${t}` };
      return cfg;
    });
    // Auto-logout on 401 (expired/invalid token) so users see the login page
    const resId = axios.interceptors.response.use(
      r => r,
      err => {
        if (err?.response?.status === 401) {
          localStorage.removeItem('da_token');
          setToken(null);
          setUser(null);
        }
        return Promise.reject(err);
      }
    );
    return () => {
      axios.interceptors.request.eject(reqId);
      axios.interceptors.response.eject(resId);
    };
  }, []);

  // On mount / token change, fetch current user
  useEffect(() => {
    if (!token) { setUser(null); setLoading(false); return; }
    axios.get(`${BASE}/auth/me`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => setUser(r.data))
      .catch(() => { localStorage.removeItem('da_token'); setToken(null); setUser(null); })
      .finally(() => setLoading(false));
  }, [token]);

  const login = useCallback(async (username, password) => {
    const r = await axios.post(`${BASE}/auth/login`, { username, password });
    localStorage.setItem('da_token', r.data.token);
    setToken(r.data.token);
    setUser(r.data.user);
    return r.data.user;
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem('da_token');
    setToken(null);
    setUser(null);
  }, []);

  // Check permission helper
  const hasPerm = useCallback((module, section) => {
    if (!user) return false;
    if (user.role === 'admin') return true;
    const modPerm = user.permissions?.[module];
    // Module not in stored permissions = not yet configured; default to allowed (backward compat)
    if (modPerm === undefined || modPerm === null) return true;
    if (!modPerm?.enabled) return false;
    if (!section) return true;           // module-level check only
    if (Object.keys(modPerm.sections || {}).length === 0) return true; // no sub-sections defined
    return modPerm.sections?.[section] !== false;
  }, [user]);

  const hasModule = useCallback((module) => hasPerm(module, null), [hasPerm]);

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, hasPerm, hasModule }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
