import { css } from 'goober'

export default {
  container: css`
    display: flex;
    flex-direction: column;
    gap: 1em;
  `,
  title: css`
    font-size: 1.4em;
    margin-bottom: .5em;
  `,
  subtitle: css`
    margin-bottom: .5em;
    color: var(--muted-color);
  `,
  accountAddr: css`
    display: flex;
    gap: 1em;
    align-items: center;
    gap: .5em;
  `,
}
