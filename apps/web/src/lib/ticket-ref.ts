/** How a ticket's number is written wherever people or a service desk see it: KT-0042. */
export const ticketRef = (number: number) => `KT-${String(number).padStart(4, '0')}`;
