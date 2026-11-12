import { formatAbbreviated, formatDate, formatNumber, roundToCents } from '../format.ts';

/**
 * Контрольный экран: намеренно без ошибок. Здесь же показаны легальные трансформации
 * (L1–L4) — приманка для ложных срабатываний: они выглядят как расхождения с сырыми
 * данными API, но являются корректным представлением.
 */
export function CleanScreen() {
  const rows = [
    { id: 1, value: 1200.5 },
    { id: 2, value: 800.25 },
    { id: 3, value: 399.25 },
  ];
  const total = rows.reduce((sum, row) => sum + row.value, 0);

  return (
    <section>
      <h2>Чистый экран</h2>
      <p data-testid="clean-marker">На этом экране намеренно нет ошибок.</p>
      <table data-testid="clean-table">
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td>{row.id}</td>
              <td>{formatNumber(row.value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p data-testid="clean-total">Итого: {formatNumber(roundToCents(total + 0.004))}</p>
      <ul data-testid="clean-legal">
        <li data-testid="clean-abbrev">Сокращение: {formatAbbreviated(1234)}</li>
        <li data-testid="clean-number">Локальный формат: {formatNumber(1234.5678)}</li>
        <li data-testid="clean-date">Дата: {formatDate('2026-03-01T09:00:00+03:00')}</li>
      </ul>
    </section>
  );
}
