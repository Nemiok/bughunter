import { useEffect, useState } from 'react';
import { registerWidget } from '../bh-profile.ts';

const FIELDS = [
  { id: 'revenue', label: 'Выручка' },
  { id: 'cost', label: 'Себестоимость' },
  { id: 'margin', label: 'Маржа' },
  { id: 'region', label: 'Регион' },
];

const STEPS = ['Шаг 1: поля отчёта', 'Шаг 2: фильтры', 'Шаг 3: проверка'];

export function WizardScreen() {
  const [step, setStep] = useState(0);
  const [shelf, setShelf] = useState<string[]>([]);
  const [saved, setSaved] = useState<number[]>([]);

  const label = (id: string): string => FIELDS.find((field) => field.id === id)?.label ?? id;

  // Полка объявлена виджетом профиля: результат перетаскивания наблюдаем через проекцию,
  // а не только по тексту в DOM, который в снимок элементов не попадает.
  useEffect(() => registerWidget({
    descriptor: { widget: 'shelf', kind: 'dom', node: '[data-testid="shelf"]' },
    extract: () => ({ step: STEPS[step], items: shelf.map((id) => label(id)), saved: saved.length }),
  }), [step, shelf, saved]);

  async function save(): Promise<void> {
    const response = await fetch('/api/wizard/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: shelf }),
    });
    const body = await response.json() as { id: number };
    setSaved((previous) => [...previous, body.id]);
  }

  return (
    <section>
      <h2>Мастер отчёта</h2>
      <p data-testid="wizard-step">{STEPS[step]}</p>

      {step === 0 && (
        <>
          <ul data-testid="wizard-fields">
            {FIELDS.map((field) => (
              <li
                key={field.id}
                data-testid={`field-${field.id}`}
                draggable
                // Источник перетаскивания обязан быть фокусируемым: это и доступность с
                // клавиатуры, и единственная причина, по которой цель видна в снимке ядра.
                tabIndex={0}
                onDragStart={(event) => event.dataTransfer.setData('text/plain', field.id)}
                style={{ cursor: 'grab' }}
              >
                {field.label}
              </li>
            ))}
          </ul>
          <div
            data-testid="shelf"
            tabIndex={0}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              const id = event.dataTransfer.getData('text/plain');
              if (id !== '') setShelf((previous) => [...previous, id]);
            }}
            style={{ minHeight: 60, border: '1px dashed #999', padding: 8 }}
          >
            <strong>Полка</strong>
            <ul data-testid="shelf-items">
              {shelf.map((id, index) => <li key={`${id}-${index}`}>{label(id)}</li>)}
            </ul>
          </div>
        </>
      )}

      {step === 1 && (
        <label>
          Период
          <select data-testid="wizard-period" defaultValue="month">
            <option value="month">Месяц</option>
            <option value="quarter">Квартал</option>
          </select>
        </label>
      )}

      {step === 2 && (
        <p data-testid="wizard-summary">
          Полей на полке: {shelf.length}. Сохранённых отчётов: {saved.length}.
        </p>
      )}

      <nav>
        <button type="button" data-testid="wizard-back" disabled={step === 0} onClick={() => setStep((value) => value - 1)}>
          Назад
        </button>
        {step < STEPS.length - 1 && (
          <button type="button" data-testid="wizard-next" onClick={() => setStep((value) => value + 1)}>
            Далее
          </button>
        )}
        {step === STEPS.length - 1 && (
          <button type="button" data-testid="wizard-save" onClick={() => void save()}>
            Сохранить отчёт
          </button>
        )}
      </nav>
    </section>
  );
}
