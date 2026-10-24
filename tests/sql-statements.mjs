// Migrations keep ordinary DDL before complete CREATE TRIGGER blocks.
export function migrationStatements(sql) {
  return sql.replace(/--[^\n]*/g, '').split(/(?=^CREATE TRIGGER)/m).flatMap(chunk => {
    const value = chunk.trim();
    return value.startsWith('CREATE TRIGGER') ? [value] : value.split(';').map(part => part.trim()).filter(Boolean);
  });
}
