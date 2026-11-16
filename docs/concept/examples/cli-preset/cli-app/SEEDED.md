# Реестр засеянных багов `cli-app`

Источник правды — `src/cli.js`. Запуск: `DB_FILE=<файл> node src/cli.js <команда> [аргументы]`.
Все замеры ниже получены запуском этой фикстуры в копии (Node.js v24.14.0).

| ID | Команда | Наблюдаемое поведение | Код выхода | Ожидаемое поведение |
|----|---------|-----------------------|------------|---------------------|
| C1 | `show никакого` на пустой БД | stdout пуст, в stderr необработанное `TypeError: Cannot read properties of undefined (reading 'total')` и стек с путём `src/cli.js:18` | 1 | Понятная ошибка «заказ не найден» без стека |
| C2 | `add banana -5` | `ok banana total=-500`; в БД `{"name":"banana","qty":-5,"total":-500}` | 0 | Отрицательное количество отвергнуто с ошибкой |
| C3 | `add apple 3` дважды | обе команды печатают `ok apple total=300`; `list` показывает две строки `apple` | 0 | Повторный `add` обновляет строку, а не добавляет вторую |
| C4 | `add x abc` | `ok x total=NaN`; `list` показывает `{"name":"x","qty":null,"total":null}` (JSON не умеет NaN) | 0 | Нечисловое количество отвергнуто с ошибкой |
| — | `list` | `[]` на пустой БД, иначе JSON-массив строк | 0 | Контроль: команда всегда корректна |

## Базовая линия (замерено)

```
$ DB_FILE=clean.json node src/cli.js add apple 3
exit=0
stdout: ok apple total=300

$ DB_FILE=clean.json node src/cli.js show apple
exit=0
stdout: 300

$ DB_FILE=clean.json node src/cli.js list
exit=0
stdout: [{"name":"apple","qty":3,"total":300}]

$ DB_FILE=missing.json node src/cli.js show никакого
exit=1
stdout: (пусто)
stderr: TypeError: Cannot read properties of undefined (reading 'total'); стек указывает на src/cli.js:18

$ DB_FILE=negative.json node src/cli.js add banana -5
exit=0
stdout: ok banana total=-500

$ DB_FILE=duplicate.json node src/cli.js add apple 3   # дважды
exit=0
stdout: ok apple total=300
stdout: ok apple total=300
$ DB_FILE=duplicate.json node src/cli.js list
exit=0
stdout: [{"name":"apple","qty":3,"total":300},{"name":"apple","qty":3,"total":300}]

$ DB_FILE=nan.json node src/cli.js add x abc
exit=0
stdout: ok x total=NaN
$ DB_FILE=nan.json node src/cli.js list
exit=0
stdout: [{"name":"x","qty":null,"total":null}]

$ DB_FILE=unknown.json node src/cli.js nope
exit=2
stderr: unknown command: nope
```

## Намеренно недостижимый баг

C3 требует двух последовательных `add` и `list` в одной сессии. Детерминированный обход
сбрасывает базу перед каждым объявленным сценарием и не содержит сценария с двумя `add` и
последующим `list`, поэтому множественность строк не проверяется. C3 оставлен для исследования
моделью: он достижим, но не покрывается sweep.
