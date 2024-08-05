import { css } from 'goober'
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

      &:hover {
        transform: scale(.95);
      }
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
      align-items: center;
      display: flex;
      justify-content: center;
      position: relative;

      .tv-lightweight-charts {
        position: relative;
        z-index: 0;
      }
    `,
    trademark: css`
      position: absolute;
      z-index: 1;
      padding: 1em;
      font-size: .7em;
      top: 0;
      left: 0;
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
  controls: css`
    background: var(--content-bg-color);
    border-radius: .5em;
    display: flex;
    flex-direction: column;
    
    ${theme.query.minDesktop} {
      overflow-y: auto;
      max-height: 750px;
    }
  `,
  actionButtons: css`
    display: flex;
    gap: .5em;
    align-items: center;
    padding: 1em;
    
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

      &:hover {
        transform: scale(.95);
      }
    }
  `,
  dropdowns: css`
    display: flex;
    gap: 1em;
    flex-direction: column;
    padding: 1em;
    padding-top: 0;

    > div {
      display: flex;
      gap: .5em;
      flex-direction: column;
    }
  `,
  columns: {
    container: css`
      border-radius: .5em;
      background-color: var(--table-td-bg-color);
      flex: 1;
    `,
    header: css`
      padding: 1em;
      display: flex;
      flex-direction: row;
      user-select: none;
      align-items: center;
      justify-content: space-between;

      > :nth-child(2) {
        display: flex;
        flex-direction: row;
        gap: .5em;
        align-items: center;
      }
    `,
    item: css`
      display: flex;
      gap: 0.5em;
      flex-direction: column;
      padding: 1em;

      &:nth-child(odd) {
        background: ${theme.apply({ xelis: `#161616`, dark: `#161616`, light: `#e9e9e9` })};
      }

      &:nth-child(even) {
        background: var(--table-td-bg-color);
      }
    `,
    row: css`
      display: flex;
      gap: .5em;
      align-items: center;

      > div {
        display: flex;
        flex-direction: row;
        gap: .5em;
      }
    `
  },
  customInput: css`
    padding: .5em;
    border: thin solid white;
    border-radius: .5em;
    gap: .5em;
    display: flex;
    align-items: center;
    flex-wrap: wrap;
  `,
  page: css`
    display: flex;
    gap: 1em;
    flex-direction: column;

    ${theme.query.minDesktop} {
      display: flex;
      gap: 1em;
      flex-direction: row;
    }
    
    > :nth-child(1) {
      max-height: 400px;
      min-height: 400px;
      flex: 1;
      overflow: auto;
      background: var(--content-bg-color);
      border-radius: .5em;

      ${theme.query.minDesktop} {
        max-height: 750px;
        min-height: 750px;
      }

      > div {
        overflow: visible;
      }
    }
  `,
  header: {
    title: css`
      font-size: 1.2em;
      padding: 1em;
      background: var(--content-bg-color);
      border-radius: .5em;
      margin: 1em 0;
    `,
    subtitle: css`
      margin-top: .5em;
      font-size: .8em;
      opacity: .5;
    `
  }
}