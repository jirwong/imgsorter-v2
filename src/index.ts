import { env } from './env';
import { addI } from './simple-add-i';

function test(input: string) {
  console.log('Hello.');
  console.log('String received: ', input);
  console.log('NODE_ENV:', env.NODE_ENV);
  console.log('PORT:', env.PORT);
  const res = addI(1, 2);
  console.log('Res:', res);
}

test('Input');
