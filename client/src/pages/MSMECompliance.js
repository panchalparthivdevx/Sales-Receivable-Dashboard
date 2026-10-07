import React from 'react';
import MSMEReport from './MSMEReport';
import MSMEInterestReport from './MSMEInterestReport';
import MSMEForm1Report from './MSMEForm1Report';

export default function MSMECompliance() {
  return (
    <div style={{ padding: '1.5rem 2rem', minHeight: '100vh', background: '#F9F9F9' }}>
      <div style={{ marginBottom: '1.25rem' }}>
        <h1 style={{ color: '#18191B', fontSize: '1.25rem', fontWeight: 700, margin: 0 }}>MSME Compliance</h1>
        <p style={{ color: '#5D6C7B', fontSize: '0.82rem', margin: '4px 0 0' }}>
          Monitor MSMED Act compliance — track payment timelines, quarterly interest liability and half-yearly Form-1 obligations for MSME-registered vendors
        </p>
      </div>
      <MSMEReport />
      <MSMEInterestReport />
      <MSMEForm1Report />
    </div>
  );
}
