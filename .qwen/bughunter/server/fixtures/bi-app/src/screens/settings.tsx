import { useState } from 'react';

export function SettingsScreen() {
  const [name, setName] = useState('');
  const [message, setMessage] = useState('');

  function exportCsv(): void {
    setMessage('Экспорт запущен');
  }

  return (
    <section>
      <h2>Настройки</h2>
      <form data-testid="settings-form" onSubmit={(event) => event.preventDefault()}>
        <label htmlFor="settings-name">Имя отчёта по умолчанию</label>
        <input
          id="settings-name"
          data-testid="settings-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <button type="submit" data-testid="settings-save">Сохранить</button>
        <button type="button" data-testid="export-csv" onClick={exportCsv}>Экспорт CSV</button>
      </form>
      <p data-testid="settings-message">{message}</p>
    </section>
  );
}
