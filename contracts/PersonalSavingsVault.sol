// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract PersonalSavingsVault is ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Status { None, Active, Withdrawn, Aborted }

    struct Goal {
        uint256 target;
        uint256 funded;
        Status status;
    }

    IERC20 public immutable token;
    mapping(address owner => mapping(bytes32 id => Goal)) public goals;

    error InvalidToken();
    error InvalidTarget();
    error GoalExists();
    error InactiveGoal();
    error InvalidDeposit();
    error TargetNotReached();
    error TargetReached();
    error UnexpectedTransferAmount();

    event GoalOpened(address indexed owner, bytes32 indexed id, uint256 target);
    event Deposited(address indexed owner, bytes32 indexed id, uint256 amount);
    event GoalClosed(address indexed owner, bytes32 indexed id, Status status, uint256 amount);

    constructor(IERC20 savingsToken) {
        if (address(savingsToken).code.length == 0) revert InvalidToken();
        token = savingsToken;
    }

    function openGoal(bytes32 id, uint256 target) external {
        if (target == 0) revert InvalidTarget();
        if (goals[msg.sender][id].status != Status.None) revert GoalExists();
        goals[msg.sender][id] = Goal(target, 0, Status.Active);
        emit GoalOpened(msg.sender, id, target);
    }

    function deposit(bytes32 id, uint256 amount) external nonReentrant {
        Goal storage goal = activeGoal(id);
        if (amount == 0 || amount > goal.target - goal.funded) revert InvalidDeposit();
        uint256 beforeBalance = token.balanceOf(address(this));
        goal.funded += amount;
        token.safeTransferFrom(msg.sender, address(this), amount);
        if (token.balanceOf(address(this)) != beforeBalance + amount) revert UnexpectedTransferAmount();
        emit Deposited(msg.sender, id, amount);
    }

    function withdraw(bytes32 id) external nonReentrant {
        Goal storage goal = activeGoal(id);
        if (goal.funded != goal.target) revert TargetNotReached();
        close(id, goal, Status.Withdrawn);
    }

    function abort(bytes32 id) external nonReentrant {
        Goal storage goal = activeGoal(id);
        if (goal.funded == goal.target) revert TargetReached();
        close(id, goal, Status.Aborted);
    }

    function activeGoal(bytes32 id) private view returns (Goal storage goal) {
        goal = goals[msg.sender][id];
        if (goal.status != Status.Active) revert InactiveGoal();
    }

    function close(bytes32 id, Goal storage goal, Status status) private {
        uint256 amount = goal.funded;
        goal.status = status;
        if (amount != 0) {
            uint256 beforeRecipient = token.balanceOf(msg.sender);
            uint256 beforeVault = token.balanceOf(address(this));
            token.safeTransfer(msg.sender, amount);
            if (
                token.balanceOf(msg.sender) != beforeRecipient + amount
                || token.balanceOf(address(this)) != beforeVault - amount
            ) revert UnexpectedTransferAmount();
        }
        emit GoalClosed(msg.sender, id, status, amount);
    }
}
