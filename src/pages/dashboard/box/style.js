import { css } from 'goober'
import theme from 'xelis-explorer/src/style/theme'

export default {
  container: css`
    background-color: ${theme.apply({ xelis: `rgb(0 0 0 / 50%)`, dark: `rgb(0 0 0 / 50%)`, light: `rgb(255 255 255 / 50%)` })};
    border-radius: .5em;
    color: var(--text-color);
    min-width: 17em;
    max-width: 17em;
    min-height: 13em;
    max-height: 13em;
    position: relative;
    display: flex;
    flex-direction: column;
  `,
  title: css`
    font-size: .9em;
    opacity: .6;
    padding: 1em 1em .5em 1em;
  `,
  subtitle: {
    container: css`
      font-weight: bold;
      font-size: 1.4em;
      padding: 0 1rem .5rem 1rem;
    `,
    extra: css`
      font-weight: bold;
      font-size: .6em;
      margin-left: .3em;
      opacity: .4;
    `
  },
  content: css`
    flex: 1;
    overflow: auto;
  `,
  loading: css`
    display: flex;
    align-items: center;
    justify-content: center;
    margin-top: -1em;
    height: 100%;
    opacity: .7;
  `,
  topRightIcon: css`
    position: absolute;
    top: 1em;
    right: 1em;
    display: flex;
    gap: .6em;

    > * {
      cursor: pointer;
      opacity: .5;

      &:hover {
        opacity: 1;
        transform: scale(.9);
      }
    }
  `,
  bottomInfo: css`
    position: absolute;
    padding: .5em .75em;
    font-size: .8em;
    bottom: 1em;
    left: 50%;
    transform: translateX(-50%);
    background-color: ${theme.apply({ xelis: ` rgb(0 0 0 / 50%)`, dark: ` rgb(0 0 0 / 50%)`, light: ` rgb(255 255 255 / 50%)` })};
    white-space: nowrap;
    border-radius: .5em;
  `,
  table: css`
    width: 100%;
    white-space: nowrap;
    
    th {
      padding: .5rem 1rem;
      font-weight: bold;
      text-align: left;
    }
    
    td {
      border-top: thin solid ${theme.apply({ xelis: `rgb(255 255 255 / 10%)`, dark: `rgb(255 255 255 / 10%)`, light: `rgb(0 0 0 / 10%)` })};
      padding: .5rem 1rem;
      font-size: .8em;
    }
  `,
  chart: {
    container: css`
      overflow: hidden;
      border-bottom-left-radius: .5em;
      border-bottom-right-radius: .5em;
    `,
    tooltip: css`
      background-color: ${theme.apply({ xelis: `rgb(0 0 0 / 60%)`, dark: `rgb(0 0 0 / 60%)`, light: `rgb(255 255 255 / 60%)` })} !important;
      border: none !important;
      border-radius: 0.5em;
      padding: 0.5em !important;
    `
  }
}