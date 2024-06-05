import { css } from 'goober'
import { scaleOnHover } from 'xelis-explorer/src/style/animate'
import theme from 'xelis-explorer/src/style/theme'

export default {
  list: {
    container: css`
      display: grid;
      gap: 1em;
      grid-template-columns: 1fr;
      margin-top: 2em;

      ${theme.query.minDesktop} {
        grid-template-columns: 1fr 1fr;
      }
    `,
    item: css`
      background: var(--bg-color);
      padding: 1em;
      border-radius: .5em;
      cursor: pointer;
      text-decoration: none;
      color: var(--text-color);
      border: thin solid ${theme.apply({ xelis: `#39746d`, dark: `#414141`, light: `#b9b9b9` })};
      ${scaleOnHover()}
    `,
    title: css`
      font-size: 1.2em;
      font-weight: bold;
      margin-bottom: .25em;
    `,
    description: css`
      font-size: .9em;
      opacity: .6;
    `
  },
  chart: {
    container: css`
      height: 15rem;
      margin-bottom: 1em;
      background: #00000075;
      align-items: center;
      display: flex;
      justify-content: center;
      border-radius: 0.5em;
      position: relative;

      .tv-lightweight-charts {
        border-radius: .5em;
        position: relative;
        z-index: 0;
      }

      ${theme.query.minMobile} {
        height: 30em;
      }

      ${theme.query.minDesktop} {
        height: 35em;
      }
    `,
    trademark: css`
      position: absolute;
      z-index: 1;
      padding: 1em;
      font-size: .7em;
    `,
    tradingView: css`
      border-radius: .5em;
      position: relative;
      z-index: 0;
    `,
    loading: css`
      position: absolute;
      z-index: 2;
      display: flex;
      width: 100%;
      height: 100%;
      justify-content: center;
      align-items: center;
      font-size: 2em;
      top: 0;
    `
  },
  controls: {
    container: css`
      padding: 1em;
      display: flex;
      flex-direction: column;
      gap: 1em;
      overflow-y: auto;
    `,
    header: {
      container: css`
        display: flex;
        justify-content: space-between;
        align-items: center;
      `,
      title: css`
        font-weight: bold;
        font-size: 1.5em;
      `,
      closeButton: css`
        border: none;
        background-color: var(--text-color);
        color: var(--bg-color);
        border-radius: 50%;
        height: 40px;
        width: 40px;
        font-size: 1em;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        transition: .25s transform;

        &:hover {
          transform: scale(0.9);
        }

        ${theme.query.minLarge} {
          display: none;
        }
      `
    },
    actionButtons: css`
      display: flex;
      gap: .5em;
      align-items: center;
      
      button {
        padding: .5em 1em;
        border-radius: .5em;
        border: none;
        background: var(--text-color);
        color: var(--bg-color);
        display: flex;
        align-items: center;
        cursor: pointer;
        white-space: nowrap;
        gap: .5em;
        ${scaleOnHover()}
      }
    `,
    rows: css`
      display: flex;
      gap: 1em;
      flex-direction: column;

      > div {
        display: flex;
        gap: .5em;
        flex-direction: column;
      }
    `,

  },
  pageHeader: {
    container: css`
      padding: 1em;
      border-radius: .5em;
      display: flex;
      background-color: var(--bg-color);
      align-items: center;
      justify-content: space-between;
      gap: .5em;
      margin: 1em 0 .5em 0;
    `,
    title: css`
      font-size: 1.4em;
      font-weight: bold;
    `,
    toggleButton: css`
      font-size: 1.2em;
      background: none;
      border: none;
      color: var(--text-color);
      cursor: pointer;
      display: flex;
      gap: .5em;
      align-items: center;
      border: thin solid var(--text-color);
      padding: .4em .6em;
      border-radius: .5em;

      ${theme.query.minLarge} {
        display: none;
      }
    `,
    params: css`
      margin-bottom: .5em;
      font-size: .8em;
      word-break: break-all;
      background: black;
      padding: 1em;
      border-radius: 0.5em;
      line-height: 1.1em;
    `
  },
  columns: {
    showAll: css`
      display: flex;
      gap: .25em;
      align-items: center;
      user-select: none;
    `,
    items: css`
      display: flex;
      gap: .5em;
      flex-direction: column;
    `,
    item: css`
      display: flex;
      gap: 0.5em;
      padding: 1em;
      border-radius: 0.5em;
      border: thin solid var(--text-color);
      color: var(--text-color);
      background: var(--table-td-bg-color);
      flex-direction: column;
    `,
    row: css`
      display: flex;
      gap: .5em;
      align-items: center;
    `
  },
}