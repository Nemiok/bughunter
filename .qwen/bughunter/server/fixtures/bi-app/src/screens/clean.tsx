import { formatNumber } from '../format.ts';

/** Контрольный экран: намеренно без ошибок, чтобы мерить ложные срабатывания. */
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
      <p data-testid="clean-total">Итого: {formatNumber(total)}</p>
    </section>
  );
}
