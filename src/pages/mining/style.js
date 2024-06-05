import { css } from 'goober'
import theme from 'xelis-explorer/src/style/theme'

export default {
  title: css`
    font-size: 1.4em;
    margin-bottom: .5em;
  `,
  subtitle: css`
    margin-bottom: .5em;
    color: var(--muted-color);
  `,
  minerAddr: css`
    display: flex;
    gap: 1em;
    align-items: center;
    gap: .5em;
  `,
  container: css`
    margin-bottom: 2em;
    display: flex;
    flex-direction: column;
    gap: 2em;
  `,
  twoRow: {
    container: css`
      display: flex;
      flex-direction: column;
      gap: 2em;

      ${theme.query.minDesktop} {
        flex-direction: row;
        gap: 1em;
      }
    `,
    content: css`
      flex: 1;
    `,
    overflow: css`
      max-height: 500px;
      overflow: auto;
    `
  },
  chart: {
    container: css`
      margin-bottom: .5em;
      background-color: ${theme.apply({ xelis: `rgb(0 0 0 / 50%)`, dark: `rgb(0 0 0 / 50%)`, light: `rgb(255 255 255 / 50%)` })};
      padding: 1em;
      border-radius: .5em;
      width: 100%; 
      height: 300px;
      position: relative;
    `,
    loading: css`
      position: absolute;
      display: flex;
      align-items: center;
      justify-content: center;
      width: 100%;
      height: 100%;
      opacity: .7;
      top: 0;
      left: 0;
    `,
    select: css`
      right: 1em;
      top: -.9em;
      position: absolute;
      font-size: 1.2em;

      background: var(--table-td-bg-color);
      border-radius: .5em;
      padding: .25em;
      border-color: transparent;
      color: var(--text-color);
    `
  }
}
