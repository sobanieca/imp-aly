import { textField } from 'imp/std/inputs'

export const keyField = ({ editing }) =>
  textField({
    field: 'key',
    secret: true,
    label: 'Key',
    type: 'password',
    autocomplete: 'off',
    required: !editing,
    help: editing
      ? 'Empty: keep the saved key.'
      : 'The key of the server, from ~/.secret/imp-aly-key on the server. This browser keeps it, and no script can read it back.',
  })
