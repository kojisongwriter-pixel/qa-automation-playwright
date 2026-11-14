#!/usr/bin/env node
// Markdown summary of a Trivy JSON report (all severities, fixable AND unfixed):
// counts per severity, then every HIGH/CRITICAL finding in full. Nothing is
// filtered out; the complete JSON report is kept next to it.
//
// Usage: node runner-image/summarize-scan.js trivy.json [trivy-version.json]

const fs = require('fs');

function summarize(report, versionInfo) {
  const findings = (report.Results || []).flatMap((r) => (r.Vulnerabilities || []).map((v) => ({ ...v, target: r.Target, type: r.Type })));
  const order = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'];
  const counts = Object.fromEntries(order.map((s) => [s, { total: 0, fixable: 0, unfixed: 0 }]));
  for (const f of findings) {
    const c = counts[f.Severity] || (counts[f.Severity] = { total: 0, fixable: 0, unfixed: 0 });
    c.total++;
    if (f.FixedVersion) c.fixable++;
    else c.unfixed++;
  }
  const db = versionInfo && versionInfo.VulnerabilityDB;
  const lines = [
    '### Vulnerability scan (all severities, fixable and unfixed)',
    `scanner: Trivy ${(versionInfo && versionInfo.Version) || (report.Trivy && report.Trivy.Version) || 'unknown'}${db ? ` · database v${db.Version} updated ${db.UpdatedAt}` : ''}`,
    `target: \`${report.ArtifactName}\` · ${(report.Results || []).map((r) => `${r.Type} ${(r.Packages || []).length || ''}`.trim()).join(', ')}`,
    '',
    '| severity | total | fixable | unfixed |',
    '|---|---:|---:|---:|',
    ...Object.entries(counts).map(([s, c]) => `| ${s} | ${c.total} | ${c.fixable} | ${c.unfixed} |`),
    '',
  ];
  const serious = findings.filter((f) => f.Severity === 'CRITICAL' || f.Severity === 'HIGH');
  lines.push(serious.length ? `HIGH/CRITICAL findings (${serious.length}):` : 'HIGH/CRITICAL findings: none');
  for (const f of serious)
    lines.push(`- ${f.Severity} ${f.VulnerabilityID} \`${f.PkgName}\` ${f.InstalledVersion} → fixed: ${f.FixedVersion || 'none'} (${f.Status || 'unknown'}, ${f.type})`);
  return { markdown: `${lines.join('\n')}\n`, counts, serious };
}

if (require.main === module) {
  const report = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const versionInfo = process.argv[3] && fs.existsSync(process.argv[3]) ? JSON.parse(fs.readFileSync(process.argv[3], 'utf8')) : null;
  process.stdout.write(summarize(report, versionInfo).markdown);
}

module.exports = { summarize };
