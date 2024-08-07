import { css } from 'goober'
import theme from 'xelis-explorer/src/style/theme'

export default {
  tabDropdown: css`
    margin-bottom: 1em;
    font-size: 1.2em;
  `,
  error: css`
    padding: 1em;
    color: white;
    font-weight: bold;
    background-color: var(--error-color);
    margin-bottom: 1em;
    border-radius: .5em;
  `,
  profile: {
    knownAccount: css`
      border-radius: .75em;
      padding: 1em;
      background: var(--content-bg-color);
      margin-bottom: 1em;
      line-height: 1.2em;
      display: flex;
      gap: 1em;
      align-items: center;

      i {
        font-size: 2em;
      }
    `,
    container: css`
      padding: 1.5em;
      margin-bottom: 1em;
      background: var(--content-bg-color);
      border-radius: 1em;
      color: var(--text-color);
      display: flex;
      flex-direction: column;
      gap: 1.5em;
      align-items: center;

      ${theme.query.minDesktop} {
        flex-direction: row;
      }
    `,
    stats: css`
      display: flex;
      gap: 1em;
      flex-direction: column;
    `,
    statsItems: css`
      display: flex;
      gap: 1em 2.5em;
      flex-wrap: wrap;
    `,
    addr: css`
      font-size: 1.4em;
      word-break: break-all;
    `,
    item: {
      container: css`
        display: flex;
        flex-direction: column;
        gap: .25em;
      `,
      title: css`
        color: var(--muted-color);
        font-size: .9em;
      `,
      value: css`
        font-size: 1.4em;
      `
    }
  },
  transfers: {
    rows: css`
      visibility: hidden;
      position: fixed;

      &[data-visible="true"] {
        visibility: visible;
        position: inherit;
      }
    `,
    container: css`
      display: flex;
      flex-wrap: wrap;
      gap: .5em;
    `,
    item: css`
      display: flex;
      gap: .5em;
      border: 2px solid rgb(0 0 0 / 50%);
      padding: .5em;
      border-radius: .5em;
      align-items: center;
    `,
    button: css`
      padding: 0.3em .5em;
      border: 2px solid var(--text-color);
      border-radius: .5em;
      cursor: pointer;
      background: none;
      color: var(--text-color);
      display: flex;
      gap: .5em;
      align-items: center;
      opacity: .6;
      transition: .25s all;

      &:hover {
        opacity: 1;
      }
    `
  }
}