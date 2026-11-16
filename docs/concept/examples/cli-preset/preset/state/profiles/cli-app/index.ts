// Профиль мини-фикстуры: инвентарь команд и признак мутации базы.
export default {
  commands: [
    {
      command: 'add',
      template: 'add <name> <qty>',
      sampleArgv: ['add', 'apple', '3'],
      description: 'Добавить заказ в базу',
      mutates: true,
    },
    {
      command: 'show',
      template: 'show <name>',
      sampleArgv: ['show', 'apple'],
      description: 'Показать сумму заказа по имени',
      mutates: false,
    },
    {
      command: 'list',
      template: 'list',
      sampleArgv: ['list'],
      description: 'Показать все заказы',
      mutates: false,
    },
  ],
};
